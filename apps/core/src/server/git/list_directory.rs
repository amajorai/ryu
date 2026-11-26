//! The folder picker's directory listing.

use super::*;

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

#[cfg(test)]
#[path = "list_directory_tests.rs"]
mod tests;
