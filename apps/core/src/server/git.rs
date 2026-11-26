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

use crate::identity_verify::permissions;

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

/// `(status, {"success":false,"error":<error>})`, the envelope every git exit uses.
fn git_failure(status: StatusCode, error: impl Into<String>) -> Response {
    (
        status,
        Json(json!({ "success": false, "error": error.into() })),
    )
        .into_response()
}

/// A worker-thread join failure: logged as `<op>: join error: …`, answered as 500.
fn join_failure(op: &str, error: impl std::fmt::Display) -> Response {
    tracing::error!("{op}: join error: {error}");
    git_failure(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// 403 `insufficient permissions: <permission>` unless `caller` holds `permission`.
async fn require_permission(
    state: &crate::server::ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    permission: &str,
) -> Result<(), Response> {
    crate::server::enforce_permission(state, caller, permission)
        .await
        .map_err(|_| {
            git_failure(
                StatusCode::FORBIDDEN,
                format!("insufficient permissions: {permission}"),
            )
        })
}

/// 400 unless `cwd` is non-empty and names an existing directory.
fn require_cwd_dir(cwd: &str) -> Result<(), Response> {
    if cwd.is_empty() {
        return Err(git_failure(StatusCode::BAD_REQUEST, "cwd is required"));
    }
    if !Path::new(cwd).is_dir() {
        return Err(git_failure(
            StatusCode::BAD_REQUEST,
            "cwd is not a directory",
        ));
    }
    Ok(())
}

// The git engine (everything that shells `git`) lives in the `ryu-workspace`
// crate; these handlers are the thin axum surface over it.
use ryu_workspace::git::{
    checkout_branch, clone_public_repository, create_branch, create_pull_request,
    initialize_repository, list_branches, query_file_diff, query_git_state, reverse_text_edits,
    run_git_action, run_git_remote_action, ReverseEditsOutcome, TextReplacement,
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
    if let Err(response) = require_cwd_dir(&body.cwd) {
        return response;
    }
    let cwd = match canonical_remote_workspace(&body.cwd) {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(error) => {
            return git_failure(StatusCode::BAD_REQUEST, error);
        }
    };
    let result = tokio::task::spawn_blocking(move || initialize_repository(&cwd)).await;

    match result {
        Ok(Ok(outcome)) => Json(json!(outcome)).into_response(),
        Ok(Err(msg)) => git_failure(StatusCode::CONFLICT, msg),
        Err(error) => join_failure("git_init", error),
    }
}

pub(crate) async fn git_init_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<GitInitBody>,
) -> axum::response::Response {
    if let Err(denied) = require_permission(&state, &caller, permissions::AGENT_EDIT).await {
        return denied;
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
        return git_failure(StatusCode::BAD_REQUEST, "cwd must be a directory");
    }
    if let Err(error) = validate_review_paths(&body.paths) {
        return git_failure(StatusCode::BAD_REQUEST, error);
    }
    let GitFileDiffBody { cwd, paths } = body;
    match tokio::task::spawn_blocking(move || query_file_diff(&cwd, &paths)).await {
        Ok(Ok(diff)) => Json(json!(diff)).into_response(),
        Ok(Err(error)) => git_failure(StatusCode::BAD_REQUEST, error),
        Err(error) => join_failure("git_file_diff", error),
    }
}

pub(crate) async fn git_file_diff_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<GitFileDiffBody>,
) -> Response {
    if let Err(denied) = require_permission(&state, &caller, permissions::AGENT_VIEW).await {
        return denied;
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
        return git_failure(StatusCode::BAD_REQUEST, "cwd must be a directory");
    }
    let replacements = match validated_replacements(body.plan) {
        Ok(replacements) => replacements,
        Err(error) => {
            return git_failure(StatusCode::BAD_REQUEST, error);
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
        Ok(Err(error)) => git_failure(StatusCode::BAD_REQUEST, error),
        Err(error) => join_failure("git_reverse_edits", error),
    }
}

pub(crate) async fn git_reverse_edits_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<GitReverseEditsBody>,
) -> Response {
    if let Err(denied) = require_permission(&state, &caller, permissions::AGENT_EDIT).await {
        return denied;
    }
    git_reverse_edits(JsonBody(body)).await
}

mod credit;
mod list_directory;
mod project_folders;
mod repo_actions;

pub(crate) use credit::{git_credit_enabled, git_credit_enabled_for_node};
pub use list_directory::*;
pub use project_folders::*;
pub use repo_actions::*;

#[cfg(test)]
mod tests;
