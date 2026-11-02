//! File-tree item commands confined beneath a workspace root.

use crate::editors::open_in_editor;
use crate::fs_command_error::{FsCommandError, FsCommandErrorCode};
use crate::workspace_move;

/// Resolve a file-tree item beneath its workspace root. Both paths must already
/// exist: canonicalization is what closes symlink and `..` traversal escapes.
pub(crate) fn resolve_workspace_item_path(
    workspace_root: &std::path::Path,
    relative_path: &std::path::Path,
) -> Result<std::path::PathBuf, FsCommandError> {
    if relative_path.is_absolute() {
        return Err(FsCommandError::with_detail(
            FsCommandErrorCode::InvalidPath,
            "workspace item path must be relative",
        ));
    }

    let canonical_root = std::fs::canonicalize(workspace_root)
        .map_err(|e| FsCommandError::with_detail(FsCommandErrorCode::WorkspaceUnavailable, e))?;
    let canonical_item = std::fs::canonicalize(canonical_root.join(relative_path))
        .map_err(|e| FsCommandError::with_detail(FsCommandErrorCode::ItemUnavailable, e))?;
    if !canonical_item.starts_with(&canonical_root) {
        return Err(FsCommandError::new(FsCommandErrorCode::OutsideProject));
    }
    Ok(canonical_item)
}

/// A launcher that would not start: the OS text stays the technical detail.
fn launch_failed(error: impl ToString) -> FsCommandError {
    FsCommandError::with_detail(FsCommandErrorCode::LaunchFailed, error)
}

pub(crate) fn launch_default_app(
    app: &tauri::AppHandle,
    path: &std::path::Path,
) -> Result<(), FsCommandError> {
    use tauri_plugin_shell::ShellExt;

    let path = path.to_string_lossy().into_owned();
    let result = if cfg!(windows) {
        app.shell().command("explorer").args([path]).spawn()
    } else if cfg!(target_os = "macos") {
        app.shell().command("open").args([path]).spawn()
    } else {
        app.shell().command("xdg-open").args([path]).spawn()
    };
    result.map(|_| ()).map_err(launch_failed)
}

/// List existing workspace paths with Git ignore rules and without stale index entries.
#[tauri::command]
pub(crate) async fn list_workspace_files(root: String) -> Result<Vec<String>, FsCommandError> {
    workspace_move::list_files(std::path::Path::new(&root))
}

/// Move one user-selected workspace item without shell interpolation or replacing
/// an occupied destination. The native helper owns confinement and atomicity.
#[tauri::command]
pub(crate) async fn move_workspace_item(
    root: String,
    source_path: String,
    destination_path: String,
) -> Result<(), FsCommandError> {
    workspace_move::move_item(
        std::path::Path::new(&root),
        std::path::Path::new(&source_path),
        std::path::Path::new(&destination_path),
    )
}

/// Open an existing file-tree item in its OS-default app or a detected editor.
/// Shell-like targets receive the containing directory when the item is a file.
#[tauri::command]
pub(crate) async fn open_workspace_item(
    app: tauri::AppHandle,
    root: String,
    path: String,
    editor: Option<String>,
) -> Result<(), FsCommandError> {
    let item =
        resolve_workspace_item_path(std::path::Path::new(&root), std::path::Path::new(&path))?;
    let Some(editor) = editor else {
        return launch_default_app(&app, &item);
    };

    let is_shell = matches!(
        editor.as_str(),
        "terminal" | "gitbash" | "powershell" | "cmd"
    );
    let target = if is_shell && item.is_file() {
        item.parent().unwrap_or(&item)
    } else {
        &item
    };
    open_in_editor(app, editor, Some(target.to_string_lossy().into_owned())).await
}

/// Reveal an existing file-tree item in the platform file manager.
#[tauri::command]
pub(crate) async fn reveal_workspace_item(
    app: tauri::AppHandle,
    root: String,
    path: String,
) -> Result<(), FsCommandError> {
    use tauri_plugin_shell::ShellExt;

    let item =
        resolve_workspace_item_path(std::path::Path::new(&root), std::path::Path::new(&path))?;
    let item_string = item.to_string_lossy().into_owned();
    let result = if cfg!(windows) {
        app.shell()
            .command("explorer")
            .args([format!("/select,{item_string}")])
            .spawn()
    } else if cfg!(target_os = "macos") {
        app.shell()
            .command("open")
            .args(["-R".to_string(), item_string])
            .spawn()
    } else {
        let target = if item.is_dir() {
            &item
        } else {
            item.parent().unwrap_or(&item)
        };
        app.shell()
            .command("xdg-open")
            .args([target.to_string_lossy().into_owned()])
            .spawn()
    };
    result.map(|_| ()).map_err(launch_failed)
}

#[cfg(test)]
mod workspace_item_path_tests {
    use super::resolve_workspace_item_path;
    use crate::fs_command_error::FsCommandErrorCode;

    fn test_root(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("ryu-{name}-{}", std::process::id()))
    }

    #[test]
    fn resolves_an_existing_item_beneath_the_workspace() {
        let root = test_root("workspace-item-inside");
        let nested = root.join("src");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("main.rs"), "fn main() {}\n").unwrap();

        let resolved =
            resolve_workspace_item_path(&root, std::path::Path::new("src/main.rs")).unwrap();

        assert_eq!(
            resolved,
            std::fs::canonicalize(nested.join("main.rs")).unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_parent_traversal_outside_the_workspace() {
        let container = test_root("workspace-item-escape");
        let root = container.join("project");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(container.join("outside.txt"), "outside\n").unwrap();

        let error =
            resolve_workspace_item_path(&root, std::path::Path::new("../outside.txt")).unwrap_err();

        assert_eq!(error.code, FsCommandErrorCode::OutsideProject);
        std::fs::remove_dir_all(container).unwrap();
    }

    #[test]
    fn a_vanished_item_is_coded_unavailable_with_the_os_text_as_detail() {
        let root = test_root("workspace-item-missing");
        std::fs::create_dir_all(&root).unwrap();

        let error =
            resolve_workspace_item_path(&root, std::path::Path::new("gone.txt")).unwrap_err();

        assert_eq!(error.code, FsCommandErrorCode::ItemUnavailable);
        assert!(error.detail.is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn absolute_and_rootless_paths_get_their_own_codes() {
        let root = test_root("workspace-item-absolute");
        std::fs::create_dir_all(&root).unwrap();
        let absolute = std::fs::canonicalize(&root).unwrap().join("x.txt");

        let error = resolve_workspace_item_path(&root, &absolute).unwrap_err();
        assert_eq!(error.code, FsCommandErrorCode::InvalidPath);

        let missing_root = root.join("not-here");
        let error =
            resolve_workspace_item_path(&missing_root, std::path::Path::new("x.txt")).unwrap_err();
        assert_eq!(error.code, FsCommandErrorCode::WorkspaceUnavailable);
        std::fs::remove_dir_all(root).unwrap();
    }
}
