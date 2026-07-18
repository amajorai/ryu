// apps/core/src/server/git.rs
//
// Read-only git status for a workspace folder. Shells `git rev-parse` and
// `git status --porcelain` against a caller-supplied cwd. This is Core (it
// reads what-is; no policy), returned over GET /api/git/status?cwd=<path>.

use axum::{extract::Query, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;

// The git engine (everything that shells `git`) lives in the `ryu-workspace`
// crate; these handlers are the thin axum surface over it.
use ryu_workspace::git::{
    checkout_branch, create_branch, list_branches, query_git_state, run_git_action,
};

#[derive(Deserialize)]
pub struct GitStatusQuery {
    cwd: Option<String>,
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

fn default_include_unstaged() -> bool {
    true
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
pub async fn git_checkout(Json(body): Json<GitCheckoutBody>) -> axum::response::Response {
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
pub async fn git_create_branch(Json(body): Json<GitCheckoutBody>) -> axum::response::Response {
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
pub async fn git_commit_push(Json(body): Json<GitCommitPushBody>) -> axum::response::Response {
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

// ── Create a new project folder ("Start from scratch") ────────────────────────

#[derive(Deserialize)]
pub struct NewFolderBody {
    name: String,
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
pub async fn create_project_folder(Json(body): Json<NewFolderBody>) -> axum::response::Response {
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

/// `GET /api/workspace/list?path=<abs>` — list the sub-directories of a folder ON
/// THE NODE, so the desktop can present a node-aware folder picker (the native OS
/// dialog only sees the desktop host, which is wrong when the node is remote).
///
/// Placement rationale: this is Core — it reads *what is* on the node's own
/// filesystem, no policy. Read-only: it returns directory names only, never file
/// contents. `~` is expanded; a missing/blank path defaults to the home directory.
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
    let target = if trimmed.is_empty() {
        home.clone()
    } else if let Some(rest) = trimmed.strip_prefix("~") {
        home.join(rest.trim_start_matches(['/', '\\']))
    } else {
        std::path::PathBuf::from(trimmed)
    };

    // Canonicalize so `..` segments resolve and the returned path is absolute.
    let target = std::fs::canonicalize(&target).unwrap_or(target);
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
            entries.push(json!({ "name": name, "path": item.path().to_string_lossy() }));
        }
    }
    entries.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    });

    Json(json!({
        "path": target.to_string_lossy(),
        "parent": target.parent().map(|p| p.to_string_lossy().into_owned()),
        "home": home.to_string_lossy(),
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
        let base = std::env::temp_dir().join(format!("ryu_listdir_{}", std::process::id()));
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
        let resp = list_directory(Query(ListDirQuery {
            path: Some("/no/such/ryu/dir/xyz".to_string()),
        }))
        .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn list_directory_defaults_to_home_when_path_absent() {
        let resp = list_directory(Query(ListDirQuery { path: None })).await;
        let (status, json) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        // Home is a real directory, so listing it succeeds and echoes the home path.
        // On Windows, `canonicalize` yields a verbatim (`\\?\`) prefix that the raw
        // home path lacks, so strip it before comparing.
        let strip_verbatim = |p: &str| p.trim_start_matches(r"\\?\").to_string();
        let home = dirs::home_dir().unwrap().to_string_lossy().into_owned();
        assert_eq!(
            strip_verbatim(json["path"].as_str().unwrap()),
            strip_verbatim(&home)
        );
    }
}
