//! Project file read/write commands for the in-app editors.

use crate::plugin_file_resource;

/// Read a UTF-8 text file by absolute path — backs the in-app markdown editor
/// opening project files from the active workspace folder.
#[tauri::command]
pub(crate) async fn read_project_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

/// Bounded byte-preserving reads for a host-selected plugin file resource.
#[tauri::command]
pub(crate) async fn read_project_file_binary(path: String) -> Result<String, String> {
    plugin_file_resource::read_binary(&path)
}

#[tauri::command]
pub(crate) async fn write_project_file_binary(path: String, blob: String) -> Result<(), String> {
    plugin_file_resource::write_binary(&path, &blob)
}

/// Read one committed workspace file without passing its path through a shell.
/// Diff hydration handles repository-controlled paths, so keep the git refspec as
/// one discrete argument and reject traversal/control characters before spawning.
#[tauri::command]
pub(crate) async fn read_git_project_file(folder: String, path: String) -> Result<String, String> {
    use std::path::Component;

    let workspace = std::fs::canonicalize(&folder)
        .map_err(|e| format!("invalid workspace folder {folder}: {e}"))?;
    if !workspace.is_dir() {
        return Err(format!("workspace folder is not a directory: {folder}"));
    }
    if path.is_empty() || path.chars().any(|character| character.is_control()) {
        return Err("invalid committed file path".to_string());
    }
    let relative = std::path::Path::new(&path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("committed file path must stay inside the workspace".to_string());
    }

    let spec = format!("HEAD:{path}");
    let output = std::process::Command::new("git")
        .current_dir(workspace)
        .args(["show", spec.as_str()])
        .output()
        .map_err(|e| format!("read {path} from HEAD: {e}"))?;
    if !output.status.success() {
        return Err(format!("unable to read {path} from HEAD"));
    }
    String::from_utf8(output.stdout)
        .map_err(|e| format!("committed file {path} is not valid UTF-8: {e}"))
}

/// Write a UTF-8 text file by absolute path — the markdown editor's autosave.
#[tauri::command]
pub(crate) async fn write_project_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("write {path}: {e}"))
}

/// Write one Markdown file below a user-selected project folder. Memory's Git
/// source binding uses a relative path so the renderer cannot accidentally
/// write outside the folder it just granted to the app through the picker.
#[tauri::command]
pub(crate) async fn write_project_markdown(
    root: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    use std::path::Component;

    let root =
        std::fs::canonicalize(&root).map_err(|e| format!("invalid project folder {root}: {e}"))?;
    if !root.is_dir() {
        return Err("project folder is not a directory".to_string());
    }
    let relative = std::path::Path::new(&relative_path);
    if relative.is_absolute()
        || relative_path.is_empty()
        || relative_path
            .chars()
            .any(|character| character.is_control())
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
        || !relative_path.to_ascii_lowercase().ends_with(".md")
    {
        return Err("relative Markdown path must stay inside the project folder".to_string());
    }
    let destination = root.join(relative);
    let parent = destination
        .parent()
        .ok_or_else(|| "Markdown path has no parent".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("create Markdown folder {}: {e}", parent.display()))?;
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("resolve Markdown folder {}: {e}", parent.display()))?;
    if !canonical_parent.starts_with(&root) {
        return Err("Markdown path resolves outside the project folder".to_string());
    }
    if std::fs::symlink_metadata(&destination)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("refusing to overwrite a symlink".to_string());
    }
    std::fs::write(&destination, content)
        .map_err(|e| format!("write {}: {e}", destination.display()))
}

/// List markdown files under a canonical workspace without following symlinks.
fn collect_project_markdown(root: &std::path::Path) -> Result<Vec<String>, String> {
    let root = std::fs::canonicalize(root)
        .map_err(|error| format!("invalid workspace folder: {error}"))?;
    if !root.is_dir() {
        return Err("workspace folder is not a directory".to_string());
    }

    fn walk(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<String>, depth: usize) {
        if depth > 6 || out.len() >= 1000 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist"
            {
                continue;
            }
            if file_type.is_dir() {
                walk(root, &path, out, depth + 1);
            } else if file_type.is_file()
                && path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                    e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown")
                })
            {
                if let Ok(canonical) = std::fs::canonicalize(&path) {
                    if canonical.starts_with(root) {
                        if let Some(s) = canonical.to_str() {
                            out.push(s.to_owned());
                        }
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(&root, &root, &mut out, 0);
    out.sort();
    Ok(out)
}

/// List markdown files under a folder (bounded recursion) for the file picker.
#[tauri::command]
pub(crate) async fn list_project_markdown(folder: String) -> Result<Vec<String>, String> {
    collect_project_markdown(std::path::Path::new(&folder))
}

#[cfg(test)]
mod project_markdown_tests {
    use super::collect_project_markdown;

    fn test_root(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("ryu-{name}-{}", std::process::id()))
    }

    #[test]
    fn returns_only_markdown_inside_the_workspace() {
        let root = test_root("markdown-inside");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/readme.md"), "inside\n").unwrap();
        std::fs::write(root.join("docs/ignore.txt"), "ignore\n").unwrap();

        let files = collect_project_markdown(&root).unwrap();

        assert_eq!(
            files,
            vec![std::fs::canonicalize(root.join("docs/readme.md"))
                .unwrap()
                .to_string_lossy()]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_a_symlinked_directory_outside_the_workspace() {
        use std::os::unix::fs::symlink;

        let container = test_root("markdown-symlink");
        let root = container.join("project");
        let outside = container.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), "outside\n").unwrap();
        symlink(&outside, root.join("linked")).unwrap();

        let files = collect_project_markdown(&root).unwrap();

        assert!(files.is_empty());
        std::fs::remove_dir_all(container).unwrap();
    }
}
