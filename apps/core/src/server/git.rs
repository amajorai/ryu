// apps/core/src/server/git.rs
//
// Git workspace operations for a caller-supplied folder. The workspace crate
// owns every `git` invocation; this module keeps the Core HTTP surface thin and
// returns status, remote-action, and commit/PR results as JSON.

use axum::{
    extract::{rejection::JsonRejection, Extension, FromRequest, Query, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;

/// A `Json<T>` body extractor whose REJECTIONS are JSON too.
///
/// Every hand-written exit in these handlers answers
/// `{"success":false,"error":"…"}`, but axum's built-in `Json` rejects a bad
/// request *before* the handler runs and renders that rejection as `text/plain`
/// ("Expected request with `Content-Type: application/json`", "Failed to
/// deserialize the JSON body…"). A client that reasonably assumed JSON — the
/// desktop's git client did — then fed that prose to `JSON.parse` and showed the
/// user `Unexpected token 'E', "Expected r"... is not valid JSON` instead of the
/// actual reason. Wrapping the extractor keeps the status code axum chose (415,
/// 422, …) and re-clothes the reason in the same JSON envelope as every other
/// exit, so `/api/git/*` and `/api/workspace/new-folder` have no non-JSON path.
pub struct JsonBody<T>(pub T);

#[axum::async_trait]
impl<T, S> FromRequest<S> for JsonBody<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => Err(json_rejection_response(&rejection)),
        }
    }
}

/// Render a `JsonRejection` as `(its status, {"success":false,"error":<its text>})`.
fn json_rejection_response(rejection: &JsonRejection) -> Response {
    (
        rejection.status(),
        Json(json!({ "success": false, "error": rejection.body_text() })),
    )
        .into_response()
}

// The git engine (everything that shells `git`) lives in the `ryu-workspace`
// crate; these handlers are the thin axum surface over it.
use ryu_workspace::git::{
    checkout_branch, clone_repository, create_branch, create_pull_request, initialize_repository,
    list_branches, query_file_diff, query_git_state, reverse_text_edits, run_git_action,
    run_git_remote_action, ReverseEditsOutcome, TextReplacement,
};

const MAX_FILE_REVIEW_PATHS: usize = 64;
const MAX_REVERSE_EDITS: usize = 256;
const MAX_REVERSE_EDIT_TEXT_BYTES: usize = 256 * 1024;
const MAX_REVERSE_EDIT_TOTAL_BYTES: usize = 1024 * 1024;
const MAX_REVERSE_PATH_BYTES: usize = 4096;

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct GitFileDiffBody {
    cwd: String,
    paths: Vec<String>,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields, tag = "kind")]
pub enum ReverseEditBody {
    #[serde(rename = "replace")]
    Replace {
        after: String,
        before: String,
        path: String,
    },
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields, tag = "kind")]
pub enum ReverseEditPlanBody {
    #[serde(rename = "text-replacements")]
    TextReplacements { edits: Vec<ReverseEditBody> },
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct GitReverseEditsBody {
    cwd: String,
    plan: ReverseEditPlanBody,
}

#[derive(Deserialize)]
pub struct GitStatusQuery {
    cwd: Option<String>,
}

#[derive(Deserialize)]
pub struct GitInitBody {
    cwd: String,
}

#[derive(Deserialize)]
pub struct GitCheckoutBody {
    cwd: String,
    branch: String,
}

#[derive(Deserialize)]
pub struct GitCommitPushBody {
    cwd: String,
    /// Commit message. Defaults to "Update via Ryu" when empty/omitted.
    #[serde(default)]
    message: Option<String>,
    /// Action to run: "commit", "commit-push", or "push".
    #[serde(default)]
    action: Option<String>,
    /// Whether to stage unstaged changes before committing.
    #[serde(default = "default_include_unstaged")]
    include_unstaged: bool,
}

#[derive(Deserialize)]
pub struct GitRemoteBody {
    cwd: String,
}

fn default_include_unstaged() -> bool {
    true
}

/// `POST /api/git/init` `{ cwd }`
///
/// Initializes a folder as a local repository with `main` as its initial
/// branch. It deliberately does not stage or commit files; the normal commit
/// action remains the explicit next step before a provider publish.
#[utoipa::path(
    post,
    path = "/api/git/init",
    tag = "Git",
    summary = "{ cwd }",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn git_init(JsonBody(body): JsonBody<GitInitBody>) -> axum::response::Response {
    if body.cwd.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "cwd is required" })),
        )
            .into_response();
    }

    let path = Path::new(&body.cwd);
    if !path.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "cwd is not a directory" })),
        )
            .into_response();
    }

    let cwd = match canonical_remote_workspace(&body.cwd) {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "error": error })),
            )
                .into_response();
        }
    };
    let result = tokio::task::spawn_blocking(move || initialize_repository(&cwd)).await;

    match result {
        Ok(Ok(outcome)) => Json(json!(outcome)).into_response(),
        Ok(Err(msg)) => (
            StatusCode::CONFLICT,
            Json(json!({ "success": false, "error": msg })),
        )
            .into_response(),
        Err(error) => {
            tracing::error!("git_init: join error: {error}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": "internal error" })),
            )
                .into_response()
        }
    }
}

pub(crate) async fn git_init_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<GitInitBody>,
) -> axum::response::Response {
    if crate::server::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "success": false,
                "error": "insufficient permissions: agent.edit"
            })),
        )
            .into_response();
    }
    git_init(JsonBody(body)).await
}

fn validate_review_paths(paths: &[String]) -> Result<(), &'static str> {
    if paths.is_empty() || paths.len() > MAX_FILE_REVIEW_PATHS {
        return Err("paths must contain between 1 and 64 files");
    }
    if paths
        .iter()
        .any(|path| path.is_empty() || path.len() > MAX_REVERSE_PATH_BYTES)
    {
        return Err("each path must contain between 1 and 4096 bytes");
    }
    Ok(())
}

fn validated_replacements(plan: ReverseEditPlanBody) -> Result<Vec<TextReplacement>, &'static str> {
    let ReverseEditPlanBody::TextReplacements { edits } = plan;
    if edits.is_empty() || edits.len() > MAX_REVERSE_EDITS {
        return Err("plan edits must contain between 1 and 256 replacements");
    }
    let mut total_bytes = 0usize;
    let mut replacements = Vec::with_capacity(edits.len());
    for edit in edits {
        let ReverseEditBody::Replace {
            after,
            before,
            path,
        } = edit;
        if path.is_empty() || path.len() > MAX_REVERSE_PATH_BYTES {
            return Err("each path must contain between 1 and 4096 bytes");
        }
        if after.is_empty()
            || after == before
            || after.len() > MAX_REVERSE_EDIT_TEXT_BYTES
            || before.len() > MAX_REVERSE_EDIT_TEXT_BYTES
        {
            return Err("each replacement must contain bounded, changed text");
        }
        total_bytes = total_bytes
            .saturating_add(path.len())
            .saturating_add(after.len())
            .saturating_add(before.len());
        replacements.push(TextReplacement {
            after,
            before,
            path,
        });
    }
    if total_bytes > MAX_REVERSE_EDIT_TOTAL_BYTES {
        return Err("the reverse-edit plan exceeds the 1 MiB limit");
    }
    Ok(replacements)
}

#[utoipa::path(
    post,
    path = "/api/git/file-diff",
    tag = "Git",
    summary = "Read the current diff for selected files",
    request_body = GitFileDiffBody,
    responses(
        (status = 200, description = "Selected file diff", body = serde_json::Value),
        (status = 400, description = "Invalid repository or paths", body = serde_json::Value)
    )
)]
pub async fn git_file_diff(JsonBody(body): JsonBody<GitFileDiffBody>) -> Response {
    if body.cwd.is_empty() || !Path::new(&body.cwd).is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "cwd must be a directory" })),
        )
            .into_response();
    }
    if let Err(error) = validate_review_paths(&body.paths) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": error })),
        )
            .into_response();
    }
    let GitFileDiffBody { cwd, paths } = body;
    match tokio::task::spawn_blocking(move || query_file_diff(&cwd, &paths)).await {
        Ok(Ok(diff)) => Json(json!(diff)).into_response(),
        Ok(Err(error)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": error })),
        )
            .into_response(),
        Err(error) => {
            tracing::error!("git_file_diff: join error: {error}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": "internal error" })),
            )
                .into_response()
        }
    }
}

pub(crate) async fn git_file_diff_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<GitFileDiffBody>,
) -> Response {
    if crate::server::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "success": false,
                "error": "insufficient permissions: agent.view"
            })),
        )
            .into_response();
    }
    git_file_diff(JsonBody(body)).await
}

#[utoipa::path(
    post,
    path = "/api/git/reverse-edits",
    tag = "Git",
    summary = "Reverse exact text edits from one assistant turn",
    request_body = GitReverseEditsBody,
    responses(
        (status = 200, description = "Edits reversed", body = serde_json::Value),
        (status = 400, description = "Invalid plan", body = serde_json::Value),
        (status = 409, description = "Files changed since the turn", body = serde_json::Value)
    )
)]
pub async fn git_reverse_edits(JsonBody(body): JsonBody<GitReverseEditsBody>) -> Response {
    if body.cwd.is_empty() || !Path::new(&body.cwd).is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "cwd must be a directory" })),
        )
            .into_response();
    }
    let replacements = match validated_replacements(body.plan) {
        Ok(replacements) => replacements,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "error": error })),
            )
                .into_response()
        }
    };
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || reverse_text_edits(&cwd, &replacements)).await {
        Ok(Ok(outcome @ ReverseEditsOutcome::Applied { .. })) => {
            Json(json!(outcome)).into_response()
        }
        Ok(Ok(outcome @ ReverseEditsOutcome::Conflict { .. })) => {
            (StatusCode::CONFLICT, Json(json!(outcome))).into_response()
        }
        Ok(Err(error)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": error })),
        )
            .into_response(),
        Err(error) => {
            tracing::error!("git_reverse_edits: join error: {error}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": "internal error" })),
            )
                .into_response()
        }
    }
}

pub(crate) async fn git_reverse_edits_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<GitReverseEditsBody>,
) -> Response {
    if crate::server::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "success": false,
                "error": "insufficient permissions: agent.edit"
            })),
        )
            .into_response();
    }
    git_reverse_edits(JsonBody(body)).await
}

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
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "cwd and branch are required" })),
        )
            .into_response();
    }

    let path = Path::new(&body.cwd);
    if !path.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "cwd is not a directory" })),
        )
            .into_response();
    }

    let GitCheckoutBody { cwd, branch } = body;
    let result = tokio::task::spawn_blocking(move || checkout_branch(&cwd, &branch)).await;

    match result {
        Ok(Ok(branch)) => Json(json!({ "success": true, "branch": branch })).into_response(),
        Ok(Err(msg)) => (
            StatusCode::CONFLICT,
            Json(json!({ "success": false, "error": msg })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("git_checkout: join error: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": "internal error" })),
            )
                .into_response()
        }
    }
}

pub(crate) async fn git_checkout_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<GitCheckoutBody>,
) -> axum::response::Response {
    if crate::server::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "success": false,
                "error": "insufficient permissions: agent.edit"
            })),
        )
            .into_response();
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
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "cwd and branch are required" })),
        )
            .into_response();
    }

    let path = Path::new(&body.cwd);
    if !path.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "cwd is not a directory" })),
        )
            .into_response();
    }

    let GitCheckoutBody { cwd, branch } = body;
    let result = tokio::task::spawn_blocking(move || create_branch(&cwd, &branch)).await;

    match result {
        Ok(Ok(branch)) => Json(json!({ "success": true, "branch": branch })).into_response(),
        Ok(Err(msg)) => (
            StatusCode::CONFLICT,
            Json(json!({ "success": false, "error": msg })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("git_create_branch: join error: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": "internal error" })),
            )
                .into_response()
        }
    }
}

pub(crate) async fn git_create_branch_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<GitCheckoutBody>,
) -> axum::response::Response {
    if crate::server::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "success": false,
                "error": "insufficient permissions: agent.edit"
            })),
        )
            .into_response();
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
    if body.cwd.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "cwd is required" })),
        )
            .into_response();
    }

    let path = Path::new(&body.cwd);
    if !path.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "cwd is not a directory" })),
        )
            .into_response();
    }

    let GitCommitPushBody {
        cwd,
        message,
        action,
        include_unstaged,
    } = body;
    let action = action.unwrap_or_else(|| "commit-push".to_string());
    if !matches!(action.as_str(), "commit" | "commit-push" | "push") {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "invalid git action" })),
        )
            .into_response();
    }
    let message = message
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "Update via Ryu".to_string());

    let result = tokio::task::spawn_blocking(move || {
        run_git_action(&cwd, &message, &action, include_unstaged)
    })
    .await;

    match result {
        Ok(Ok(outcome)) => Json(json!(outcome)).into_response(),
        Ok(Err(msg)) => (
            StatusCode::CONFLICT,
            Json(json!({ "success": false, "error": msg })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("git_commit_push: join error: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": "internal error" })),
            )
                .into_response()
        }
    }
}

pub(crate) async fn git_commit_push_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<GitCommitPushBody>,
) -> axum::response::Response {
    if crate::server::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "success": false,
                "error": "insufficient permissions: agent.edit"
            })),
        )
            .into_response();
    }
    git_commit_push(JsonBody(body)).await
}

async fn git_remote(
    body: GitRemoteBody,
    action: &'static str,
    operation_name: &'static str,
) -> axum::response::Response {
    if body.cwd.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "cwd is required" })),
        )
            .into_response();
    }

    let raw_path = Path::new(&body.cwd);
    if !raw_path.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "cwd is not a directory" })),
        )
            .into_response();
    }
    let path = match canonical_remote_workspace(&body.cwd) {
        Ok(path) => path,
        Err(error) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "success": false, "error": error })),
            )
                .into_response();
        }
    };
    if !path.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "cwd is not a directory" })),
        )
            .into_response();
    }

    let cwd = path.to_string_lossy().into_owned();
    let result = tokio::task::spawn_blocking(move || run_git_remote_action(&cwd, action)).await;

    match result {
        Ok(Ok(outcome)) => Json(json!(outcome)).into_response(),
        Ok(Err(msg)) => (
            StatusCode::CONFLICT,
            Json(json!({ "success": false, "error": msg })),
        )
            .into_response(),
        Err(error) => {
            tracing::error!("{operation_name}: join error: {error}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": "internal error" })),
            )
                .into_response()
        }
    }
}

/// Remote Git actions mutate the node's filesystem and therefore must stay in
/// the same node-home boundary as the remote workspace picker. The protected
/// route's node bearer admits the request; `agent.edit` above is the shared-node
/// user/resource gate. Canonicalizing before the check closes symlink and `..`
/// escapes.
fn canonical_remote_workspace(raw: &str) -> Result<std::path::PathBuf, String> {
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
    if crate::server::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "success": false,
                "error": "insufficient permissions: agent.edit"
            })),
        )
            .into_response();
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
    if crate::server::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "success": false,
                "error": "insufficient permissions: agent.edit"
            })),
        )
            .into_response();
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
    if body.cwd.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "cwd is required" })),
        )
            .into_response();
    }

    let path = Path::new(&body.cwd);
    if !path.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": "cwd is not a directory" })),
        )
            .into_response();
    }

    let cwd = match canonical_remote_workspace(&body.cwd) {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "error": error })),
            )
                .into_response();
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
    let result = tokio::task::spawn_blocking(move || {
        create_pull_request(
            &cwd,
            title.as_deref(),
            body.as_deref(),
            base.as_deref(),
            draft,
            include_unstaged,
        )
    })
    .await;

    match result {
        Ok(Ok(outcome)) => Json(json!(outcome)).into_response(),
        Ok(Err(msg)) => (
            StatusCode::CONFLICT,
            Json(json!({ "success": false, "error": msg })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("git_pull_request: join error: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": "internal error" })),
            )
                .into_response()
        }
    }
}

pub(crate) async fn git_pull_request_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<GitPullRequestBody>,
) -> axum::response::Response {
    if crate::server::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "success": false,
                "error": "insufficient permissions: agent.edit"
            })),
        )
            .into_response();
    }
    git_pull_request(JsonBody(body)).await
}

// ── Create a new project folder ("Start from scratch") ────────────────────────

#[derive(Deserialize)]
pub struct NewFolderBody {
    name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloneFolderBody {
    /// GitHub HTTPS or SSH clone URL.
    url: String,
    /// Optional destination folder name. Defaults to the repository name.
    #[serde(default)]
    name: Option<String>,
}

#[derive(Clone, Copy)]
enum GithubCloneTransport {
    Https,
    Ssh,
}

fn github_repository_name_from_path(path: &str) -> Result<String, String> {
    let segments: Vec<&str> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.len() != 2 {
        return Err("GitHub URL must include exactly owner/repository".to_string());
    }
    for segment in &segments {
        if segment == &"."
            || segment == &".."
            || segment
                .chars()
                .any(|character| !(character.is_ascii_alphanumeric() || ".-_".contains(character)))
        {
            return Err("GitHub URL contains an invalid repository path".to_string());
        }
    }
    let repository = segments[1].strip_suffix(".git").unwrap_or(segments[1]);
    if repository.is_empty() {
        return Err("GitHub URL must include a repository name".to_string());
    }
    Ok(repository.to_string())
}

/// Accept the two GitHub clone forms the picker documents: HTTPS and SSH.
/// Rejecting other hosts keeps this endpoint from becoming a generic outbound
/// Git transport, while the separate SSH form still lets a remote node use its
/// configured `~/.ssh` keys for private repositories.
fn parse_github_clone_url(raw: &str) -> Result<(String, GithubCloneTransport), String> {
    let source = raw.trim();
    if source.is_empty() {
        return Err("A GitHub repository URL is required".to_string());
    }
    if source.len() > 2048 || source.chars().any(char::is_control) {
        return Err("That GitHub URL is not valid".to_string());
    }

    if let Some(path) = source.strip_prefix("git@github.com:") {
        return github_repository_name_from_path(path)
            .map(|name| (name, GithubCloneTransport::Ssh));
    }

    let parsed = url::Url::parse(source).map_err(|_| {
        "Use a GitHub HTTPS URL or an SSH URL such as git@github.com:owner/repo.git".to_string()
    })?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "GitHub URL has no host".to_string())?;
    let transport = match parsed.scheme() {
        "https"
            if host.eq_ignore_ascii_case("github.com")
                || host.eq_ignore_ascii_case("www.github.com") =>
        {
            if !parsed.username().is_empty() || parsed.password().is_some() {
                return Err("GitHub HTTPS URLs cannot contain credentials".to_string());
            }
            if parsed.port().is_some_and(|port| port != 443) {
                return Err("GitHub HTTPS URLs must use port 443".to_string());
            }
            GithubCloneTransport::Https
        }
        "ssh" if host.eq_ignore_ascii_case("github.com") => {
            if parsed.username() != "git"
                || parsed.password().is_some()
                || parsed.port().is_some_and(|port| port != 22)
            {
                return Err("GitHub SSH URLs must use the git user and port 22".to_string());
            }
            GithubCloneTransport::Ssh
        }
        _ => {
            return Err("Only GitHub HTTPS and SSH clone URLs are supported".to_string());
        }
    };
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("GitHub clone URLs cannot contain a query or fragment".to_string());
    }
    let path = parsed
        .path_segments()
        .map(|segments| segments.collect::<Vec<_>>().join("/"))
        .unwrap_or_default();
    github_repository_name_from_path(&path).map(|name| (name, transport))
}

fn clone_error(status: StatusCode, error: impl Into<String>) -> axum::response::Response {
    (
        status,
        Json(json!({ "success": false, "error": error.into() })),
    )
        .into_response()
}

/// `POST /api/workspace/clone` `{ url, name? }`
///
/// Clone a GitHub repository into `~/Documents/Ryu/<name>` on the node serving
/// this request. SSH URLs run on that node, so its existing SSH config and keys
/// are used; no private key crosses the desktop boundary. The destination is
/// registered by the desktop only after this operation returns successfully.
#[utoipa::path(
    post,
    path = "/api/workspace/clone",
    tag = "Git",
    summary = "Clone a GitHub repository into a project folder",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn clone_project_folder(
    JsonBody(body): JsonBody<CloneFolderBody>,
) -> axum::response::Response {
    let url = body.url.trim().to_string();
    let (repository_name, transport) = match parse_github_clone_url(&url) {
        Ok(parsed) => parsed,
        Err(error) => return clone_error(StatusCode::BAD_REQUEST, error),
    };
    let name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(&repository_name)
        .to_string();
    if let Err(error) = validate_folder_name(&name) {
        return clone_error(StatusCode::BAD_REQUEST, error);
    }

    let port = match transport {
        GithubCloneTransport::Https => 443,
        GithubCloneTransport::Ssh => 22,
    };
    if let Err(error) = crate::server::resolve_guarded_host("github.com", port).await {
        return clone_error(StatusCode::BAD_GATEWAY, error);
    }

    let Some(docs) = dirs::document_dir() else {
        return clone_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not resolve the Documents directory",
        );
    };
    let projects_root = docs.join("Ryu");
    if let Err(error) = std::fs::create_dir_all(&projects_root) {
        return clone_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to create the project folder: {error}"),
        );
    }
    let root_string = projects_root.to_string_lossy().into_owned();
    let projects_root = match canonical_remote_workspace(&root_string) {
        Ok(root) => root,
        Err(error) => return clone_error(StatusCode::FORBIDDEN, error),
    };
    let destination = projects_root.join(&name);
    if std::fs::symlink_metadata(&destination).is_ok() {
        return clone_error(
            StatusCode::CONFLICT,
            format!("A project folder named \"{name}\" already exists"),
        );
    }

    let clone_destination = destination.clone();
    let result =
        tokio::task::spawn_blocking(move || clone_repository(&url, &clone_destination)).await;
    match result {
        Ok(Ok(())) => Json(json!({
            "success": true,
            "name": name,
            "path": destination.to_string_lossy(),
        }))
        .into_response(),
        Ok(Err(error)) => clone_error(StatusCode::CONFLICT, error),
        Err(error) => {
            tracing::error!("clone_project_folder: join error: {error}");
            clone_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        }
    }
}

pub(crate) async fn clone_project_folder_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<CloneFolderBody>,
) -> axum::response::Response {
    if crate::server::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return clone_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: agent.edit",
        );
    }
    clone_project_folder(JsonBody(body)).await
}

/// `POST /api/workspace/new-folder` `{ name }`
///
/// Create a fresh, empty project folder under `~/Documents/Ryu/<name>` and return
/// its absolute path so the desktop's "Start from scratch" flow can open it. This
/// is Core: it owns the local filesystem (the desktop's Tauri fs ACL is
/// intentionally narrow), so folder creation lives here rather than in the client.
/// `name` is validated to a single path segment — no separators, `..`, or control
/// characters — so it can never escape the Ryu projects root. Returns HTTP 409
/// when a folder of that name already exists (so the picker asks for another).
#[utoipa::path(
    post,
    path = "/api/workspace/new-folder",
    tag = "Git",
    summary = "{ name }",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn create_project_folder(
    JsonBody(body): JsonBody<NewFolderBody>,
) -> axum::response::Response {
    let name = body.name.trim().to_string();
    if let Err(msg) = validate_folder_name(&name) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response();
    }

    let Some(docs) = dirs::document_dir() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "could not resolve the Documents directory" })),
        )
            .into_response();
    };
    let target = docs.join("Ryu").join(&name);

    if target.exists() {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("A folder named \"{name}\" already exists") })),
        )
            .into_response();
    }

    match std::fs::create_dir_all(&target) {
        Ok(()) => Json(json!({ "path": target.to_string_lossy() })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("failed to create folder: {e}") })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub struct ListDirQuery {
    /// Absolute directory to list. When absent/empty, defaults to the node's home.
    path: Option<String>,
}

/// Sentinel path for the virtual "This PC" root on Windows: a level above every
/// drive root whose entries are the available drives. A drive root's `parent`
/// points here so "go up" can cross to another drive (`C:\` -> `D:\`), which the
/// real filesystem gives no path for.
#[cfg(windows)]
const THIS_PC: &str = "::this-pc";

/// Render a path for the client, stripping Windows verbatim (`\\?\`) and UNC
/// (`\\?\UNC\`) prefixes that `canonicalize` adds. Those prefixes are valid but
/// display as noise (`\\?\C:\...`) and are not what a user expects to see or a
/// caller expects to store. No-op on non-Windows and on already-clean paths.
fn display_path(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    s.into_owned()
}

/// The drives present on this Windows host, as folder entries for the virtual
/// "This PC" root (`{ name: "C:\\", path: "C:\\" }`).
#[cfg(windows)]
fn windows_drives() -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        if std::path::Path::new(&root).is_dir() {
            out.push(json!({ "name": root, "path": root }));
        }
    }
    out
}

/// `GET /api/workspace/list?path=<abs>` — list the sub-directories of a folder in
/// the node user's home tree, so the desktop can present a node-aware folder
/// picker (the native OS dialog only sees the desktop host, which is wrong when
/// the node is remote).
///
/// Placement rationale: this is Core — it reads *what is* on the node's own
/// filesystem. Read-only: it returns directory names only, never file contents.
/// The home-tree boundary prevents a remote picker caller from enumerating the
/// node's arbitrary filesystem; `~` is expanded and a missing/blank path defaults
/// to the home directory.
/// Returns `{ path, parent, home, entries: [{ name, path }] }` (directories only,
/// sorted, hidden entries excluded).
#[utoipa::path(
    get,
    path = "/api/workspace/list",
    tag = "Git",
    summary = "list the sub-directories of a folder ON",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_directory(Query(q): Query<ListDirQuery>) -> axum::response::Response {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/"));
    let raw = q.path.unwrap_or_default();
    let trimmed = raw.trim();

    // The "This PC" sentinel is not a real path — resolve it before any
    // canonicalize/is_dir check (which would 404 it) into a drive listing.
    #[cfg(windows)]
    if trimmed.eq_ignore_ascii_case(THIS_PC) {
        return Json(json!({
            "path": THIS_PC,
            "label": "This PC",
            "parent": null,
            "home": display_path(&home),
            // Keep the virtual root useful without exposing every mounted drive:
            // the picker can enter the node user's home tree, and all subsequent
            // paths are checked against the same boundary below.
            "entries": [{ "name": display_path(&home), "path": display_path(&home) }],
        }))
        .into_response();
    }

    let target = if trimmed.is_empty() {
        home.clone()
    } else if let Some(rest) = trimmed.strip_prefix("~") {
        home.join(rest.trim_start_matches(['/', '\\']))
    } else {
        std::path::PathBuf::from(trimmed)
    };

    // Canonicalize so `..` segments and symlinks resolve before the boundary
    // check. Existing symlinks that escape the home tree are therefore rejected.
    // `canonical_ish` also handles a not-yet-existing leaf without mixing raw
    // and Windows-verbatim path prefixes in the boundary comparison.
    let target = crate::paths::canonical_ish(&target);
    let home = crate::paths::canonical_ish(&home);
    if target != home && target.strip_prefix(&home).is_err() {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "workspace path must stay inside the node home directory" })),
        )
            .into_response();
    }
    if !target.is_dir() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("Not a directory: {}", target.display()) })),
        )
            .into_response();
    }

    let read = match std::fs::read_dir(&target) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": format!("Cannot read directory: {e}") })),
            )
                .into_response();
        }
    };

    let mut entries: Vec<serde_json::Value> = Vec::new();
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        // Skip hidden/system entries, and anything that isn't a directory.
        if name.starts_with('.') {
            continue;
        }
        if item.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            entries.push(json!({ "name": name, "path": display_path(&item.path()) }));
        }
    }
    entries.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    });

    // At a drive root (`C:\`) the real parent is None; on Windows point it at the
    // virtual "This PC" root so "go up" can cross to another drive.
    let parent = target.parent().map(display_path);
    #[cfg(windows)]
    let parent = parent.or_else(|| Some(THIS_PC.to_string()));

    Json(json!({
        "path": display_path(&target),
        "parent": parent,
        "home": display_path(&home),
        "entries": entries,
    }))
    .into_response()
}

/// Validate a project-folder name is a single, safe path segment.
fn validate_folder_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("A folder name is required".to_string());
    }
    if name.chars().count() > 120 {
        return Err("That name is too long".to_string());
    }
    if name == "." || name == ".." || name.contains("..") {
        return Err("That name is not allowed".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("A folder name cannot contain slashes".to_string());
    }
    if name.chars().any(char::is_control) {
        return Err("A folder name cannot contain control characters".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_name_accepts_plain_names() {
        assert!(validate_folder_name("My Project").is_ok());
        assert!(validate_folder_name("ryu-app_2").is_ok());
    }

    #[test]
    fn folder_name_rejects_traversal_and_separators() {
        assert!(validate_folder_name("").is_err());
        assert!(validate_folder_name("..").is_err());
        assert!(validate_folder_name("a/b").is_err());
        assert!(validate_folder_name("a\\b").is_err());
        assert!(validate_folder_name("foo..bar").is_err());
        assert!(validate_folder_name("bad\nname").is_err());
    }

    #[test]
    fn github_clone_url_accepts_https_and_ssh() {
        let (https_name, _) =
            parse_github_clone_url("https://github.com/amajorai/ryu.git").unwrap();
        assert_eq!(https_name, "ryu");

        let (scp_name, _) = parse_github_clone_url("git@github.com:amajorai/ryu.git").unwrap();
        assert_eq!(scp_name, "ryu");

        let (ssh_name, _) = parse_github_clone_url("ssh://git@github.com/amajorai/ryu").unwrap();
        assert_eq!(ssh_name, "ryu");
    }

    #[test]
    fn github_clone_url_rejects_other_hosts_and_extra_paths() {
        assert!(parse_github_clone_url("https://gitlab.com/org/repo").is_err());
        assert!(parse_github_clone_url("https://github.com/org/repo/tree/main").is_err());
        assert!(parse_github_clone_url("https://token@github.com/org/repo").is_err());
        assert!(parse_github_clone_url("ssh://root@github.com/org/repo").is_err());
    }

    async fn body_json(resp: axum::response::Response) -> (StatusCode, serde_json::Value) {
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, value)
    }

    #[tokio::test]
    async fn list_directory_returns_child_dirs_and_hides_files_and_dotfiles() {
        // A temp dir with two sub-folders, one file, and one hidden folder.
        let base = dirs::home_dir()
            .unwrap()
            .join(format!(".ryu_listdir_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("alpha")).unwrap();
        std::fs::create_dir_all(base.join("beta")).unwrap();
        std::fs::create_dir_all(base.join(".hidden")).unwrap();
        std::fs::write(base.join("readme.txt"), b"x").unwrap();

        let resp = list_directory(Query(ListDirQuery {
            path: Some(base.to_string_lossy().into_owned()),
        }))
        .await;
        let (status, json) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        let names: Vec<String> = json["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap().to_string())
            .collect();
        // Only the two visible sub-directories, sorted; no file, no dotfile.
        assert_eq!(names, vec!["alpha".to_string(), "beta".to_string()]);
        assert!(json["parent"].is_string());
        assert!(json["home"].is_string());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn list_directory_404s_on_missing_path() {
        let missing = dirs::home_dir()
            .unwrap()
            .join(format!(".ryu_missing_directory_{}", std::process::id()));
        let resp = list_directory(Query(ListDirQuery {
            path: Some(missing.to_string_lossy().into_owned()),
        }))
        .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn list_directory_rejects_paths_outside_home_tree() {
        let outside = std::env::temp_dir();
        if outside.starts_with(dirs::home_dir().unwrap()) {
            return;
        }
        let resp = list_directory(Query(ListDirQuery {
            path: Some(outside.to_string_lossy().into_owned()),
        }))
        .await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn list_directory_defaults_to_home_when_path_absent() {
        let resp = list_directory(Query(ListDirQuery { path: None })).await;
        let (status, json) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        // The emitted path must never carry the Windows verbatim (`\\?\`) prefix
        // that `canonicalize` adds — `display_path` strips it. (Trivially true off
        // Windows, where no path starts with that.) This locks the display fix.
        let path = json["path"].as_str().unwrap();
        assert!(!path.starts_with(r"\\?\"), "verbatim prefix leaked: {path}");
        // Home is a real directory, so listing it succeeds and echoes the home path.
        let home = display_path(&dirs::home_dir().unwrap());
        assert_eq!(path, home);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn list_directory_this_pc_lists_drives() {
        let resp = list_directory(Query(ListDirQuery {
            path: Some(THIS_PC.to_string()),
        }))
        .await;
        let (status, json) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert!(json["parent"].is_null());
        assert_eq!(json["label"].as_str().unwrap(), "This PC");
        // The home tree is always present, so at least one entry comes back.
        assert!(!json["entries"].as_array().unwrap().is_empty());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn list_directory_drive_root_stays_outside_home_tree() {
        // Drive roots are outside the home-tree boundary. Keep the traversal guard
        // closed rather than allowing a remote picker to enumerate another drive.
        let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
        let root = format!("{system_drive}\\");
        let resp = list_directory(Query(ListDirQuery { path: Some(root) })).await;
        let (status, json) = body_json(resp).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            json["error"],
            "workspace path must stay inside the node home directory"
        );
    }

    // ── Handler validation paths ──────────────────────────────────────────────
    //
    // These exercise ONLY the pre-git validation guards (missing/empty params,
    // non-directory cwd, bad action). None of them reach `spawn_blocking`, so no
    // real `git` process is shelled and no repository is required.

    fn query(pairs: &[(&str, &str)]) -> Query<HashMap<String, String>> {
        let map = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        Query(map)
    }

    /// A path guaranteed not to be a directory on any platform.
    const NON_DIR: &str = "/no/such/ryu/dir/xyz-does-not-exist";

    #[tokio::test]
    async fn git_status_missing_cwd_is_bad_request() {
        let (status, json) = body_json(git_status(query(&[])).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(json["error"].is_string());
    }

    #[tokio::test]
    async fn git_status_empty_cwd_is_bad_request() {
        // An empty cwd is filtered out and treated as absent.
        let (status, _) = body_json(git_status(query(&[("cwd", "")])).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn git_status_non_dir_returns_not_repo() {
        let (status, json) = body_json(git_status(query(&[("cwd", NON_DIR)])).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["is_repo"], serde_json::json!(false));
    }

    #[tokio::test]
    async fn git_branches_missing_cwd_is_bad_request() {
        let (status, _) = body_json(git_branches(query(&[])).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn git_branches_non_dir_returns_empty_repo_shape() {
        let (status, json) = body_json(git_branches(query(&[("cwd", NON_DIR)])).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["is_repo"], serde_json::json!(false));
        assert!(json["current"].is_null());
        assert_eq!(json["branches"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn git_checkout_rejects_empty_fields() {
        for (cwd, branch) in [("", "main"), ("/some/path", ""), ("", "")] {
            let body = GitCheckoutBody {
                cwd: cwd.to_string(),
                branch: branch.to_string(),
            };
            let (status, json) = body_json(git_checkout(JsonBody(body)).await).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(json["success"], serde_json::json!(false));
        }
    }

    #[tokio::test]
    async fn git_checkout_rejects_non_dir_cwd() {
        let body = GitCheckoutBody {
            cwd: NON_DIR.to_string(),
            branch: "main".to_string(),
        };
        let (status, json) = body_json(git_checkout(JsonBody(body)).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(json["error"].as_str().unwrap().contains("not a directory"));
    }

    #[tokio::test]
    async fn git_create_branch_rejects_empty_and_non_dir() {
        let empty = GitCheckoutBody {
            cwd: String::new(),
            branch: "feature".to_string(),
        };
        let (status, _) = body_json(git_create_branch(JsonBody(empty)).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let non_dir = GitCheckoutBody {
            cwd: NON_DIR.to_string(),
            branch: "feature".to_string(),
        };
        let (status, json) = body_json(git_create_branch(JsonBody(non_dir)).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(json["error"].as_str().unwrap().contains("not a directory"));
    }

    #[tokio::test]
    async fn git_commit_push_rejects_empty_cwd() {
        let body = GitCommitPushBody {
            cwd: String::new(),
            message: None,
            action: None,
            include_unstaged: true,
        };
        let (status, _) = body_json(git_commit_push(JsonBody(body)).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn git_commit_push_rejects_non_dir_cwd() {
        let body = GitCommitPushBody {
            cwd: NON_DIR.to_string(),
            message: None,
            action: None,
            include_unstaged: true,
        };
        let (status, json) = body_json(git_commit_push(JsonBody(body)).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(json["error"].as_str().unwrap().contains("not a directory"));
    }

    #[tokio::test]
    async fn git_pull_and_sync_reject_empty_and_non_dir_cwd() {
        let empty = GitRemoteBody { cwd: String::new() };
        let (status, _) = body_json(git_pull(JsonBody(empty)).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let non_dir = GitRemoteBody {
            cwd: NON_DIR.to_string(),
        };
        let (status, json) = body_json(git_pull(JsonBody(non_dir)).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(json["error"].as_str().unwrap().contains("not a directory"));

        let empty = GitRemoteBody { cwd: String::new() };
        let (status, _) = body_json(git_sync(JsonBody(empty)).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let non_dir = GitRemoteBody {
            cwd: NON_DIR.to_string(),
        };
        let (status, json) = body_json(git_sync(JsonBody(non_dir)).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(json["error"].as_str().unwrap().contains("not a directory"));
    }

    #[tokio::test]
    async fn git_commit_push_rejects_invalid_action() {
        // A real, existing directory (not a git repo) so the is_dir guard passes
        // and the action-allowlist check is what rejects. `git` is never shelled
        // because the action is validated before `spawn_blocking`.
        let base = std::env::temp_dir().join(format!("ryu_gitaction_{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let body = GitCommitPushBody {
            cwd: base.to_string_lossy().into_owned(),
            message: Some("hi".to_string()),
            action: Some("rm-rf".to_string()),
            include_unstaged: false,
        };
        let (status, json) = body_json(git_commit_push(JsonBody(body)).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["error"].as_str().unwrap(), "invalid git action");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn turn_file_endpoints_bound_requests_before_git() {
        let diff = GitFileDiffBody {
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            paths: Vec::new(),
        };
        let (status, json) = body_json(git_file_diff(JsonBody(diff)).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(json["error"].as_str().unwrap().contains("between 1 and 64"));

        let reverse = GitReverseEditsBody {
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            plan: ReverseEditPlanBody::TextReplacements { edits: Vec::new() },
        };
        let (status, json) = body_json(git_reverse_edits(JsonBody(reverse)).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(json["error"]
            .as_str()
            .unwrap()
            .contains("between 1 and 256"));
    }

    #[tokio::test]
    async fn git_pull_request_rejects_empty_and_non_dir_cwd() {
        let empty = GitPullRequestBody {
            cwd: String::new(),
            title: None,
            body: None,
            base: None,
            draft: false,
            include_unstaged: true,
        };
        let (status, _) = body_json(git_pull_request(JsonBody(empty)).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let non_dir = GitPullRequestBody {
            cwd: NON_DIR.to_string(),
            title: Some("Ship it".to_string()),
            body: None,
            base: Some("main".to_string()),
            draft: false,
            include_unstaged: true,
        };
        let (status, json) = body_json(git_pull_request(JsonBody(non_dir)).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(json["error"].as_str().unwrap().contains("not a directory"));
    }

    #[tokio::test]
    async fn create_project_folder_rejects_unsafe_names() {
        // Validation fails before any filesystem write, so nothing is created.
        for bad in ["", "..", "a/b", "a\\b", "foo..bar"] {
            let body = NewFolderBody {
                name: bad.to_string(),
            };
            let (status, json) = body_json(create_project_folder(JsonBody(body)).await).await;
            assert_eq!(
                status,
                StatusCode::BAD_REQUEST,
                "name {bad:?} should be rejected"
            );
            assert!(json["error"].is_string());
        }
    }

    // ── Extractor rejections stay JSON ────────────────────────────────────────
    //
    // The reported bug was a plain-text axum rejection being fed to the desktop's
    // `JSON.parse`. These drive `JsonBody` directly (no router needed) and assert
    // that the two rejection shapes a client can trigger — wrong content type and
    // an undeserializable body — still come back as `{success:false,error:"…"}`.

    async fn reject_body(
        content_type: &str,
        body: &'static str,
    ) -> (StatusCode, serde_json::Value) {
        let req = Request::builder()
            .method("POST")
            .uri("/api/git/commit-push")
            .header("content-type", content_type)
            .body(axum::body::Body::from(body))
            .unwrap();
        let resp = JsonBody::<GitCommitPushBody>::from_request(req, &())
            .await
            .err()
            .expect("request should be rejected");
        body_json(resp).await
    }

    #[tokio::test]
    async fn json_body_rejects_wrong_content_type_with_json() {
        // The exact trigger: `fetch` combined two Content-Type record entries into
        // `application/json, application/json`, which axum's mime parse refuses.
        let (status, json) =
            reject_body("application/json, application/json", r#"{"cwd":"/tmp"}"#).await;
        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(json["success"], serde_json::json!(false));
        assert!(
            json["error"].as_str().unwrap().contains("Content-Type"),
            "rejection reason must survive into the JSON body: {json}"
        );
    }

    #[tokio::test]
    async fn json_body_rejects_malformed_body_with_json() {
        // A body missing the required `cwd` never reaches the handler's own
        // "cwd is required" branch — the deserializer rejects it first.
        let (status, json) = reject_body("application/json", r#"{"message":"hi"}"#).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(json["success"], serde_json::json!(false));
        assert!(json["error"].as_str().unwrap().contains("cwd"));
    }
}
