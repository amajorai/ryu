//! File-tree item commands: list, move, open, and reveal workspace items.

use crate::editors::open_in_editor;
use crate::workspace_move;

/// Resolve a file-tree item beneath its workspace root. Both paths must already
/// exist: canonicalization is what closes symlink and `..` traversal escapes.
fn resolve_workspace_item_path(
    workspace_root: &std::path::Path,
    relative_path: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    if relative_path.is_absolute() {
        return Err("Workspace item path must be relative".to_string());
    }

    let canonical_root = std::fs::canonicalize(workspace_root)
        .map_err(|e| format!("Invalid workspace root: {e}"))?;
    let canonical_item = std::fs::canonicalize(canonical_root.join(relative_path))
        .map_err(|e| format!("Workspace item not found: {e}"))?;
    if !canonical_item.starts_with(&canonical_root) {
        return Err("Workspace item escapes the project folder".to_string());
    }
    Ok(canonical_item)
}

fn launch_default_app(app: &tauri::AppHandle, path: &std::path::Path) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    let path = path.to_string_lossy().into_owned();
    let result = if cfg!(windows) {
        app.shell().command("explorer").args([path]).spawn()
    } else if cfg!(target_os = "macos") {
        app.shell().command("open").args([path]).spawn()
    } else {
        app.shell().command("xdg-open").args([path]).spawn()
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// List existing workspace paths with Git ignore rules and without stale index entries.
#[tauri::command]
pub(crate) async fn list_workspace_files(root: String) -> Result<Vec<String>, String> {
    workspace_move::list_files(std::path::Path::new(&root))
}

/// Move one user-selected workspace item without shell interpolation or replacing
/// an occupied destination. The native helper owns confinement and atomicity.
#[tauri::command]
pub(crate) async fn move_workspace_item(
    root: String,
    source_path: String,
    destination_path: String,
) -> Result<(), String> {
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
) -> Result<(), String> {
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
) -> Result<(), String> {
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
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod workspace_item_path_tests {
    use super::resolve_workspace_item_path;

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

        assert_eq!(error, "Workspace item escapes the project folder");
        std::fs::remove_dir_all(container).unwrap();
    }
}
