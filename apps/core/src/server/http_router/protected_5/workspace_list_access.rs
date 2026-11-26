//! The path check in front of `GET /api/workspace/list`.
//!
//! `list_directory` canonicalizes the requested folder before it applies the
//! node home boundary. On Windows, canonicalizing `\\host\share` opens it, so
//! the node connects and authenticates to a host the caller chose, and only
//! then answers 403. A `ryu://chat/new?project=` link reaches this route
//! through the desktop folder probe with no user action.
//!
//! The handler here refuses network and device paths from the query string
//! itself, before any filesystem call, and then runs the unchanged handler.
//! The network path test is the one `git_read_access.rs` carries for the git
//! read routes (PR for finding CE-1); keep the two in step.

use axum::{
    extract::Query,
    http::{StatusCode, Uri},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use crate::server::git::{list_directory, ListDirQuery};

/// `GET /api/workspace/list?path=<abs>` behind the path check.
pub(crate) async fn list_directory_checked(
    Query(pairs): Query<Vec<(String, String)>>,
    uri: Uri,
) -> Response {
    // Every `path` value is checked, so a repeated key cannot slip one past.
    for (key, value) in &pairs {
        if key == "path" {
            if let Err(error) = check_list_path(value, cfg!(windows)) {
                return (StatusCode::FORBIDDEN, Json(json!({ "error": error }))).into_response();
            }
        }
    }
    match Query::<ListDirQuery>::try_from_uri(&uri) {
        Ok(query) => list_directory(query).await,
        Err(rejection) => rejection.into_response(),
    }
}

/// Refuses, on Windows, a path that names another machine or a device. The
/// handler trims the value, so the check does too.
pub(crate) fn check_list_path(raw: &str, windows: bool) -> Result<(), String> {
    let path = raw.trim();
    if windows && (is_network_path(path) || is_device_path(path)) {
        return Err("path must be a local folder".to_string());
    }
    Ok(())
}

/// `\\host\share`, `//host/share` and the `\\?\UNC\` form. A verbatim or
/// device path to a local drive (`\\?\C:\`) is not a network path.
/// Same test as `git_read_access::is_network_path` (finding CE-1).
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

/// The Win32 device namespace (`\\.\pipe\x`, `\\.\C:`), the NT object
/// namespace (`\??\`), and a verbatim path that is not a drive path
/// (`\\?\GLOBALROOT\`, `\\?\Volume{...}\`). Only `\\?\C:\...` stays allowed,
/// because older Core builds handed that spelling back to the desktop.
pub(crate) fn is_device_path(raw: &str) -> bool {
    let normalized = raw.replace('/', "\\");
    if normalized.starts_with("\\??\\") || normalized.starts_with("\\\\.\\") {
        return true;
    }
    let Some(rest) = normalized.strip_prefix("\\\\?\\") else {
        return false;
    };
    let bytes = rest.as_bytes();
    let drive = bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes.len() == 2 || bytes[2] == b'\\');
    !drive
}

#[cfg(test)]
#[path = "workspace_list_access_test.rs"]
mod tests;
