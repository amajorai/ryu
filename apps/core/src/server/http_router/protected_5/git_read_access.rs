//! Access checks for the two read-only git routes, `GET /api/git/status` and
//! `GET /api/git/branches`.
//!
//! Both take `cwd` from the query string and are polled by the desktop header
//! and branch selector. Before this module they ran with the route bearer
//! alone: no permission, and any directory on the node. The handlers here
//! check, in order:
//!
//! 1. `agent.view`, the same gate `POST /api/git/file-diff` uses. An unbound
//!    personal node allows it for its operator, exactly as before.
//! 2. On Windows, `cwd` is not a network path. Opening `\\host\share` makes
//!    the node authenticate to a host the caller chose.
//! 3. On a shared node (bound to an organization, or enrolled and waiting for
//!    its binding), `cwd` stays inside the node home directory, the boundary
//!    the pull, sync, init and pull request routes already apply. A personal
//!    machine keeps reading workspaces on any drive.
//!
//! The git calls themselves are hardened in `ryu_workspace::git_command`.

use axum::{
    extract::{Extension, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;

use crate::identity_verify::{permissions, VerifiedCaller};
use crate::server::ServerState;

type Params = HashMap<String, String>;

/// `GET /api/git/status?cwd=<path>` behind the access checks.
pub(crate) async fn git_status_authorized(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Query(params): Query<Params>,
) -> Response {
    if let Err(denied) = authorize(&state, &caller, &params).await {
        return denied;
    }
    crate::server::git::git_status(Query(params)).await
}

/// `GET /api/git/branches?cwd=<path>` behind the access checks.
pub(crate) async fn git_branches_authorized(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Query(params): Query<Params>,
) -> Response {
    if let Err(denied) = authorize(&state, &caller, &params).await {
        return denied;
    }
    crate::server::git::git_branches(Query(params)).await
}

fn refused(error: impl Into<String>) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "success": false, "error": error.into() })),
    )
        .into_response()
}

async fn authorize(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    params: &Params,
) -> Result<(), Response> {
    let permission = permissions::AGENT_VIEW;
    crate::server::enforce_permission(state, caller, permission)
        .await
        .map_err(|_| refused(format!("insufficient permissions: {permission}")))?;
    match params.get("cwd").filter(|cwd| !cwd.is_empty()) {
        // The handler answers the missing parameter itself.
        None => Ok(()),
        Some(cwd) => check_cwd(cwd, cfg!(windows), home_boundary_applies()).map_err(refused),
    }
}

/// Whether this node confines read paths to its home directory. A personal
/// node is its owner's own machine; `enforce_permission` has already refused
/// every other caller there.
fn home_boundary_applies() -> bool {
    use crate::sidecar::control_plane::{registered_node, registered_org, NodeScope};
    if registered_node().is_some_and(|node| node.scope == NodeScope::Personal) {
        return false;
    }
    registered_org().is_some() || crate::sidecar::node_binding::node_expects_binding()
}

/// The path checks, with the platform and node kind passed in so they can be
/// tested on any machine.
pub(crate) fn check_cwd(cwd: &str, windows: bool, bounded: bool) -> Result<(), String> {
    // Before any filesystem call: `is_dir` on a network path already connects.
    if windows && is_network_path(cwd) {
        return Err("cwd must be a local path".to_string());
    }
    // A missing folder stays the handler's `{ "is_repo": false }` answer.
    if bounded && Path::new(cwd).is_dir() {
        crate::server::git::canonical_remote_workspace(cwd)?;
    }
    Ok(())
}

/// `\\host\share`, `//host/share` and the `\\?\UNC\` form. A verbatim or
/// device path to a local drive (`\\?\C:\`) is not a network path.
pub(crate) fn is_network_path(raw: &str) -> bool {
    let normalized = raw.replace('/', "\\");
    let Some(rest) = normalized.strip_prefix("\\\\") else {
        return false;
    };
    let upper = rest.to_ascii_uppercase();
    if upper.starts_with("?\\UNC\\") || upper.starts_with(".\\UNC\\") {
        return true;
    }
    !(rest.starts_with("?\\") || rest.starts_with(".\\"))
}

#[cfg(test)]
#[path = "git_read_access_test.rs"]
mod tests;
